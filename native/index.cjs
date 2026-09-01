const { existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const nativeDir = __dirname;

const platformMap = {
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "darwin-x64": ["darwin-universal", "darwin-x64"],
  "darwin-arm64": ["darwin-universal", "darwin-arm64"],
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
};

// 当前主进程代码实际调用的 native 导出（最小必需集）。
// 缺任意一个即视为绑定过旧/损坏，必须跳过换下一个候选，否则运行期
// 会以 "xxx is not a function" 崩溃（例如 2026-08 LSP 会话状态徽章事故：
// 旧绑定缺 listLspSessionStatuses 却通过校验被加载）。
const requiredExports = [
  // 核心存储与会话
  "initializeAppStorage",
  "listCustomHeaderSchemes",
  "upsertCustomHeaderScheme",
  "deleteCustomHeaderScheme",
  "reorderWorkspaceDirectories",
  "deleteWorkspaceDirectory",
  "listCheckpointDiffs",
  "restoreCheckpoints",
  "listCheckpointChangesBatch",
  "listCheckpointDiffsBatch",
  "listChatMessagesPaginated",
  "cancelRunningSubAgentSessions",
  // LSP 服务器配置与会话状态（配置中心 / 状态徽章轮询）
  "listLspServerConfigs",
  "upsertLspServerConfig",
  "deleteLspServerConfig",
  "listProjectLspServerConfigs",
  "upsertProjectLspServerConfig",
  "deleteProjectLspServerConfig",
  "listEffectiveLspServerConfigs",
  "probeLspServerCommands",
  "detectProjectStack",
  "listLspSessionStatuses",
  // 工作区条目 / 用量统计 / 计划任务
  // （历史会话引用已改为 @@conversation: 内联标签，不再需要附件表导出）
  "deleteWorkspaceEntries",
  "gitFileContent",
  "getUsageModelBreakdown",
  "reconcileScheduledTaskRuns",
  // 历史会话引用 chip 悬停预览（@@conversation: 标签注入内容预览）
  "previewConversationAttachment",
  // 项目级持久记忆（Project Memory：MCP 工具 + 面板 + 会话删除联动）
  "upsertProjectMemory",
  "listProjectMemories",
  "updateProjectMemory",
  "deleteProjectMemory",
  "clearProjectMemories",
  "getProjectMemoryStats",
  "countProjectMemoriesByConversations",
];

const platformName = platformMap[`${process.platform}-${process.arch}`];
const nodeFiles = readdirSync(nativeDir)
  .filter((file) => file.endsWith(".node"))
  .map((file) => join(nativeDir, file));

const platformNames = platformName
  ? Array.isArray(platformName)
    ? platformName
    : [platformName]
  : [];
const platformCandidates = platformNames.length
  ? nodeFiles
      .filter((file) =>
        platformNames.some((name) => file.includes(`snow_native.${name}`)),
      )
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  : [];

const candidates = [
  ...platformCandidates,
  ...nodeFiles.filter((file) => !platformCandidates.includes(file)),
];

const loadErrors = [];
let nativeBinding = null;

for (const candidate of candidates) {
  if (!existsSync(candidate)) {
    continue;
  }

  try {
    const binding = require(candidate);
    const missingExports = requiredExports.filter(
      (exportName) => typeof binding[exportName] !== "function",
    );

    if (missingExports.length > 0) {
      loadErrors.push(
        new Error(
          `${candidate} is missing native exports: ${missingExports.join(", ")}`,
        ),
      );
      continue;
    }

    nativeBinding = binding;
    break;
  } catch (error) {
    loadErrors.push(error);
  }
}

if (!nativeBinding) {
  const hint =
    loadErrors.length > 0
      ? ` Last error: ${loadErrors[loadErrors.length - 1].message}`
      : "";
  throw new Error(
    `Unable to locate compiled snow_native *.node binding. Run npm run build:rust.${hint}`,
  );
}

module.exports = nativeBinding;
